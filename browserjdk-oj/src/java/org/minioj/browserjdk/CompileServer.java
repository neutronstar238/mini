/*
 * Copyright (c) 2026 Mini-OJ contributors.
 * GNU General Public License version 2 only, with the Classpath Exception.
 */
package org.minioj.browserjdk;

import java.io.*;
import java.lang.reflect.InvocationTargetException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.*;
import javax.tools.*;

/** Independent BJOJ/1 compiler/run control server. It never reads System.in. */
public final class CompileServer {
  private static final int MAGIC = 0x424a4f4a;
  private static final int VERSION = 1;
  private static final int PING = 1;
  private static final int COMPILE_RUN = 2;
  private static final int SHUTDOWN = 3;
  private static final String RUNTIME_ID = "java21-browserjdk-compat-v2";
  private static final int COMPILE_CACHE_CAPACITY = 8;
  private static final int MAX_OUTPUT_BYTES = 1024 * 1024;

  /*
   * The cache is deliberately bytecode-only.  It never retains a Class,
   * ClassLoader, stdin, stdout, stderr, or a RunResult.  LinkedHashMap gives
   * us a small access-ordered LRU without introducing another runtime
   * dependency; CompileServer handles requests serially.
   */
  private static final LinkedHashMap<String, CacheEntry> COMPILE_CACHE =
      new LinkedHashMap<>(COMPILE_CACHE_CAPACITY, 0.75f, true);

  private static native int controlRead(byte[] target, int offset, int length);
  private static native void controlWrite(byte[] source, int offset, int length);

  private CompileServer() {}

  private static final class ControlInput extends InputStream {
    @Override public int read() throws IOException {
      byte[] one = new byte[1];
      return read(one, 0, 1) == 1 ? one[0] & 0xff : -1;
    }
    @Override public int read(byte[] bytes, int offset, int length) throws IOException {
      int n = controlRead(bytes, offset, length);
      return n <= 0 ? -1 : n;
    }
  }

  private static final class ControlOutput extends OutputStream {
    @Override public void write(int value) { write(new byte[] {(byte)value}, 0, 1); }
    @Override public void write(byte[] bytes, int offset, int length) {
      controlWrite(bytes, offset, length);
    }
  }

  private static final class SourceFile extends SimpleJavaFileObject {
    private final String source;
    SourceFile(String className, String source) {
      super(URI.create("string:///" + className.replace('.', '/') + Kind.SOURCE.extension), Kind.SOURCE);
      this.source = source;
    }
    @Override public CharSequence getCharContent(boolean ignoreEncodingErrors) { return source; }
  }

  private static final class ClassFile extends SimpleJavaFileObject {
    private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    ClassFile(String className) {
      super(URI.create("bytes:///" + className.replace('.', '/') + Kind.CLASS.extension), Kind.CLASS);
    }
    @Override public OutputStream openOutputStream() { return bytes; }
    byte[] bytes() { return bytes.toByteArray(); }
  }

  private static final class CachedClass {
    private final byte[] bytes;
    CachedClass(byte[] bytes) { this.bytes = bytes.clone(); }
    byte[] copy() { return bytes.clone(); }
  }

  private static final class CacheEntry {
    private final String sourceHash;
    private final String mainClass;
    private final Map<String, CachedClass> classes;
    private final long compileMs;

    CacheEntry(String sourceHash, String mainClass, Map<String, CachedClass> classes,
               long compileMs) {
      this.sourceHash = sourceHash;
      this.mainClass = mainClass;
      this.classes = Map.copyOf(classes);
      this.compileMs = compileMs;
    }

    Map<String, byte[]> freshClassBytes() {
      Map<String, byte[]> result = new HashMap<>();
      for (Map.Entry<String, CachedClass> entry : classes.entrySet()) {
        result.put(entry.getKey(), entry.getValue().copy());
      }
      return result;
    }
  }

  private record Compilation(String sourceHash, CacheEntry entry, boolean cacheHit,
                             long compileMs, boolean success, String diagnostics) {}

  private static final class MemoryFiles extends ForwardingJavaFileManager<JavaFileManager> {
    final Map<String, ClassFile> classes = new HashMap<>();
    MemoryFiles(JavaFileManager delegate) { super(delegate); }
    @Override public JavaFileObject getJavaFileForOutput(Location location, String className,
        JavaFileObject.Kind kind, FileObject sibling) {
      ClassFile file = new ClassFile(className);
      classes.put(className, file);
      return file;
    }

    Map<String, CachedClass> snapshot() {
      Map<String, CachedClass> result = new HashMap<>();
      for (Map.Entry<String, ClassFile> entry : classes.entrySet()) {
        result.put(entry.getKey(), new CachedClass(entry.getValue().bytes()));
      }
      return result;
    }
  }

  private static final class MemoryLoader extends ClassLoader {
    private final Map<String, byte[]> classes;
    MemoryLoader(Map<String, byte[]> classes) {
      super(ClassLoader.getPlatformClassLoader());
      this.classes = classes;
    }

    @Override protected Class<?> loadClass(String name, boolean resolve)
        throws ClassNotFoundException {
      /* Child-first only for the classes produced by this compilation.  This
       * prevents a same-named user class from being reused from a parent
       * loader, while platform classes retain normal delegation. */
      if (classes.containsKey(name)) {
        synchronized (getClassLoadingLock(name)) {
          Class<?> loaded = findLoadedClass(name);
          if (loaded == null) loaded = findClass(name);
          if (resolve) resolveClass(loaded);
          return loaded;
        }
      }
      return super.loadClass(name, resolve);
    }

    @Override protected Class<?> findClass(String name) throws ClassNotFoundException {
      byte[] bytes = classes.get(name);
      if (bytes == null) throw new ClassNotFoundException(name);
      return defineClass(name, bytes, 0, bytes.length);
    }
  }

  private static final class NonClosingFileInputStream extends FileInputStream {
    NonClosingFileInputStream() { super(FileDescriptor.in); }
    @Override public void close() { /* System.in belongs to the host bridge. */ }
  }

  private static final class CappedOutputStream extends OutputStream {
    private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    private boolean truncated;

    @Override public void write(int value) {
      if (bytes.size() < MAX_OUTPUT_BYTES) bytes.write(value);
      else truncated = true;
    }

    @Override public void write(byte[] source, int offset, int length) {
      if (length <= 0) return;
      int remaining = MAX_OUTPUT_BYTES - bytes.size();
      int accepted = Math.min(remaining, length);
      if (accepted > 0) bytes.write(source, offset, accepted);
      if (accepted < length) truncated = true;
    }

    byte[] toByteArray() { return bytes.toByteArray(); }
    boolean truncated() { return truncated; }
  }

  private record GlobalState(Properties properties, Locale defaultLocale,
                             Locale formatLocale, Locale displayLocale,
                             TimeZone timeZone) {
    static GlobalState capture() {
      Properties snapshot = new Properties();
      Properties current = System.getProperties();
      if (current != null) {
        for (String name : current.stringPropertyNames()) {
          snapshot.setProperty(name, current.getProperty(name));
        }
      }
      return new GlobalState(snapshot, Locale.getDefault(),
          Locale.getDefault(Locale.Category.FORMAT),
          Locale.getDefault(Locale.Category.DISPLAY),
          TimeZone.getDefault());
    }

    void restore() {
      Properties restored = new Properties();
      for (String name : properties.stringPropertyNames()) {
        restored.setProperty(name, properties.getProperty(name));
      }
      System.setProperties(restored);
      Locale.setDefault(defaultLocale);
      Locale.setDefault(Locale.Category.FORMAT, formatLocale);
      Locale.setDefault(Locale.Category.DISPLAY, displayLocale);
      TimeZone.setDefault((TimeZone) timeZone.clone());
    }
  }

  private record RunResult(String verdict, int exitCode, String stdout, String stderr,
                           String exceptionClass, long compileMs, long executionMs,
                           boolean cacheHit, String sourceHash, int cacheSize,
                           boolean outputTruncated) {}

  private static String sourceHash(String source) {
    try {
      byte[] digest = MessageDigest.getInstance("SHA-256")
          .digest(source.getBytes(StandardCharsets.UTF_8));
      StringBuilder result = new StringBuilder(digest.length * 2);
      for (byte value : digest) result.append(String.format(Locale.ROOT, "%02x", value & 0xff));
      return result.toString();
    } catch (NoSuchAlgorithmException impossible) {
      throw new AssertionError(impossible);
    }
  }

  private static CacheEntry findCached(String key, String sourceHash, String className) {
    CacheEntry entry = COMPILE_CACHE.get(key);
    if (entry == null || !entry.sourceHash.equals(sourceHash)
        || !entry.mainClass.equals(className)) return null;
    return entry;
  }

  private static void putCached(String key, CacheEntry entry) {
    COMPILE_CACHE.put(key, entry);
    while (COMPILE_CACHE.size() > COMPILE_CACHE_CAPACITY) {
      Iterator<String> keys = COMPILE_CACHE.keySet().iterator();
      keys.next();
      keys.remove();
    }
  }

  private static Compilation compile(String className, String source) {
    String sourceHash = sourceHash(source);
    String key = RUNTIME_ID + '\u0000' + sourceHash;
    CacheEntry cached = findCached(key, sourceHash, className);
    if (cached != null) return new Compilation(sourceHash, cached, true, 0, true, "");

    long compileStart = System.nanoTime();
    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    if (compiler == null) {
      return new Compilation(sourceHash, new CacheEntry(sourceHash, className, Map.of(), 0),
          false, 0, false, "System JavaCompiler unavailable");
    }
    DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
    StandardJavaFileManager standard = compiler.getStandardFileManager(
        diagnostics, Locale.ROOT, StandardCharsets.UTF_8);
    MemoryFiles files = new MemoryFiles(standard);
    boolean ok;
    try {
      List<String> options = List.of("-encoding", "UTF-8", "-proc:none");
      ok = Boolean.TRUE.equals(compiler.getTask(null, files, diagnostics, options, null,
          List.of(new SourceFile(className, source))).call());
    } finally {
      try { standard.close(); } catch (IOException ignored) { /* in-memory output only */ }
    }
    long compileMs = (System.nanoTime() - compileStart) / 1_000_000;
    if (!ok) {
      StringBuilder text = new StringBuilder();
      for (Diagnostic<? extends JavaFileObject> diagnostic : diagnostics.getDiagnostics()) {
        text.append(diagnostic.getKind()).append(':').append(diagnostic.getLineNumber()).append(':')
            .append(diagnostic.getMessage(Locale.ROOT)).append('\n');
      }
      return new Compilation(sourceHash, new CacheEntry(sourceHash, className,
          Map.of(), compileMs), false, compileMs, false, text.toString());
    }
    CacheEntry entry = new CacheEntry(sourceHash, className, files.snapshot(), compileMs);
    putCached(key, entry);
    return new Compilation(sourceHash, entry, false, compileMs, true, "");
  }

  private static RunResult compileAndRun(String className, String source) {
    return compileAndRun(className, source,
        new BufferedInputStream(new NonClosingFileInputStream()));
  }

  /* The compatibility harness accesses this private overload reflectively
   * with deterministic stdin; production uses the native-ring overload above. */
  private static RunResult compileAndRun(String className, String source, InputStream input) {
    Compilation compilation = compile(className, source);
    if (!compilation.success()) {
      String diagnostic = compilation.diagnostics();
      String exception = "System JavaCompiler unavailable".equals(diagnostic)
          ? "JavaCompilerUnavailable" : "";
      return new RunResult(exception.isEmpty() ? "CE" : "RE", 1, "", diagnostic, exception,
          compilation.compileMs(), 0, false, compilation.sourceHash(), COMPILE_CACHE.size(),
          false);
    }
    CacheEntry entry = compilation.entry();

    GlobalState globalState = GlobalState.capture();

    PrintStream originalOut = System.out;
    PrintStream originalErr = System.err;
    InputStream originalIn = System.in;
    CappedOutputStream stdout = new CappedOutputStream();
    CappedOutputStream stderr = new CappedOutputStream();
    String exceptionClass = "";
    int exitCode = 0;
    long runStart = System.nanoTime();
    try (PrintStream out = new PrintStream(stdout, true, StandardCharsets.UTF_8);
         PrintStream err = new PrintStream(stderr, true, StandardCharsets.UTF_8)) {
      System.setIn(input);
      System.setOut(out);
      System.setErr(err);
      Class<?> mainClass = new MemoryLoader(entry.freshClassBytes()).loadClass(className);
      mainClass.getMethod("main", String[].class).invoke(null, (Object)new String[0]);
      out.flush();
      err.flush();
    } catch (Throwable failure) {
      Throwable cause = failure instanceof InvocationTargetException && failure.getCause() != null
          ? failure.getCause() : failure;
      exceptionClass = cause.getClass().getName();
      cause.printStackTrace(new PrintStream(stderr, true, StandardCharsets.UTF_8));
      exitCode = 1;
    } finally {
      System.setIn(originalIn);
      System.setOut(originalOut);
      System.setErr(originalErr);
      try { globalState.restore(); } catch (Throwable restoreFailure) {
        restoreFailure.printStackTrace(new PrintStream(stderr, true, StandardCharsets.UTF_8));
        if (exceptionClass.isEmpty()) exceptionClass = restoreFailure.getClass().getName();
        exitCode = 1;
      }
    }
    long executionMs = (System.nanoTime() - runStart) / 1_000_000;
    return new RunResult(exitCode == 0 ? "AC" : "RE", exitCode,
        new String(stdout.toByteArray(), StandardCharsets.UTF_8),
        new String(stderr.toByteArray(), StandardCharsets.UTF_8),
        exceptionClass, compilation.compileMs(), executionMs, compilation.cacheHit(),
        compilation.sourceHash(), COMPILE_CACHE.size(),
        stdout.truncated() || stderr.truncated());
  }

  private static RunResult safeCompileAndRun(String className, String source) {
    try {
      return compileAndRun(className, source);
    } catch (Throwable failure) {
      StringWriter trace = new StringWriter();
      failure.printStackTrace(new PrintWriter(trace));
      return new RunResult("RE", 1, "", trace.toString(), failure.getClass().getName(), 0, 0,
          false, sourceHash(source), COMPILE_CACHE.size(), false);
    }
  }

  private static String quote(String text) {
    StringBuilder out = new StringBuilder(text.length() + 16).append('"');
    for (int i = 0; i < text.length(); i++) {
      char c = text.charAt(i);
      switch (c) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        case '\b' -> out.append("\\b");
        case '\f' -> out.append("\\f");
        case '\n' -> out.append("\\n");
        case '\r' -> out.append("\\r");
        case '\t' -> out.append("\\t");
        default -> {
          if (c < 0x20) out.append(String.format("\\u%04x", (int)c));
          else out.append(c);
        }
      }
    }
    return out.append('"').toString();
  }

  private static void respond(DataOutputStream output, int requestId, RunResult result) throws IOException {
    String json = "{\"protocol\":\"BJOJ/1\",\"requestId\":" + requestId
        + ",\"verdict\":" + quote(result.verdict())
        + ",\"exitCode\":" + result.exitCode()
        + ",\"stdout\":" + quote(result.stdout())
        + ",\"stderr\":" + quote(result.stderr())
        + ",\"exceptionClass\":" + quote(result.exceptionClass())
        + ",\"compileMs\":" + result.compileMs()
        + ",\"executionMs\":" + result.executionMs()
        + ",\"cacheHit\":" + result.cacheHit()
        + ",\"sourceHash\":" + quote(result.sourceHash())
        + ",\"cacheSize\":" + result.cacheSize()
        + ",\"outputTruncated\":" + result.outputTruncated() + "}";
    byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
    output.writeInt(bytes.length);
    output.write(bytes);
    output.flush();
  }

  public static void main(String[] args) throws Exception {
    DataInputStream input = new DataInputStream(new BufferedInputStream(new ControlInput()));
    DataOutputStream output = new DataOutputStream(new ControlOutput());
    for (;;) {
      int frameLength = input.readInt();
      if (frameLength < 12 || frameLength > 16 * 1024 * 1024) throw new IOException("invalid BJOJ frame length");
      byte[] frame = input.readNBytes(frameLength);
      if (frame.length != frameLength) throw new EOFException("truncated BJOJ frame");
      DataInputStream frameIn = new DataInputStream(new ByteArrayInputStream(frame));
      if (frameIn.readInt() != MAGIC || frameIn.readUnsignedByte() != VERSION) {
        throw new IOException("unsupported BJOJ protocol");
      }
      int opcode = frameIn.readUnsignedByte();
      frameIn.readUnsignedShort();
      int requestId = frameIn.readInt();
      if (opcode == PING) {
        String version = System.getProperty("java.runtime.version", "21");
        respond(output, requestId, new RunResult("PONG", 0, version, "", "", 0, 0,
            false, "", COMPILE_CACHE.size(), false));
      } else if (opcode == COMPILE_RUN) {
        int classLength = frameIn.readInt();
        int sourceLength = frameIn.readInt();
        if (classLength < 1 || classLength > 4096 || sourceLength < 0 || sourceLength > 12 * 1024 * 1024) {
          throw new IOException("invalid BJOJ source dimensions");
        }
        String className = new String(frameIn.readNBytes(classLength), StandardCharsets.UTF_8);
        String source = new String(frameIn.readNBytes(sourceLength), StandardCharsets.UTF_8);
        respond(output, requestId, safeCompileAndRun(className, source));
      } else if (opcode == SHUTDOWN) {
        respond(output, requestId, new RunResult("SHUTDOWN", 0, "", "", "", 0, 0,
            false, "", COMPILE_CACHE.size(), false));
        return;
      } else {
        respond(output, requestId, new RunResult("RE", 1, "", "unknown opcode", "ProtocolError", 0, 0,
            false, "", COMPILE_CACHE.size(), false));
      }
    }
  }
}
