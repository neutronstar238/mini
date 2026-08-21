package org.minioj.browserjdk;

import java.io.ByteArrayInputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;

/**
 * Host-side production-core test.  It invokes the same CompileServer cache
 * and fresh-loader path used by the BrowserJDK image, while replacing only the
 * native stdin bridge with a deterministic ByteArrayInputStream.
 */
public final class CompileServerCacheHarness {
  private static final Method RUN;
  private static final Method VERDICT;
  private static final Method STDOUT;
  private static final Method STDERR;
  private static final Method COMPILE_MS;
  private static final Method CACHE_HIT;
  private static final Method OUTPUT_TRUNCATED;

  static {
    try {
      RUN = CompileServer.class.getDeclaredMethod("compileAndRun",
          String.class, String.class, java.io.InputStream.class);
      RUN.setAccessible(true);
      Class<?> resultType = Class.forName(
          "org.minioj.browserjdk.CompileServer$RunResult");
      VERDICT = accessor(resultType, "verdict");
      STDOUT = accessor(resultType, "stdout");
      STDERR = accessor(resultType, "stderr");
      COMPILE_MS = accessor(resultType, "compileMs");
      CACHE_HIT = accessor(resultType, "cacheHit");
      OUTPUT_TRUNCATED = accessor(resultType, "outputTruncated");
    } catch (ReflectiveOperationException error) {
      throw new ExceptionInInitializerError(error);
    }
  }

  private static Method accessor(Class<?> type, String name) throws NoSuchMethodException {
    Method method = type.getDeclaredMethod(name);
    method.setAccessible(true);
    return method;
  }

  private static Object run(String source, String input) throws Exception {
    return RUN.invoke(null, "Main", source,
        new ByteArrayInputStream(input.getBytes(StandardCharsets.UTF_8)));
  }

  private static String string(Method method, Object result) throws Exception {
    return (String) method.invoke(result);
  }

  private static long number(Method method, Object result) throws Exception {
    return ((Number) method.invoke(result)).longValue();
  }

  private static boolean bool(Method method, Object result) throws Exception {
    return (Boolean) method.invoke(result);
  }

  private static String quote(String value) {
    StringBuilder out = new StringBuilder("\"");
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      if (c == '\\' || c == '"') out.append('\\').append(c);
      else if (c == '\n') out.append("\\n");
      else if (c == '\r') out.append("\\r");
      else if (c == '\t') out.append("\\t");
      else out.append(c);
    }
    return out.append('"').toString();
  }

  private static void record(String name, Object result) throws Exception {
    System.out.println("{\"name\":" + quote(name)
        + ",\"verdict\":" + quote(string(VERDICT, result))
        + ",\"stdout\":" + quote(display(string(STDOUT, result)))
        + ",\"stderr\":" + quote(display(string(STDERR, result)))
        + ",\"compileMs\":" + number(COMPILE_MS, result)
        + ",\"cacheHit\":" + bool(CACHE_HIT, result)
        + ",\"outputTruncated\":" + bool(OUTPUT_TRUNCATED, result) + "}");
  }

  private static String display(String value) {
    if (value.length() <= 128) return value;
    return value.substring(0, 128) + "…<" + value.length() + " chars>";
  }

  public static void main(String[] args) throws Exception {
    String source = "public class Main {"
        + " public static void main(String[] a) throws Exception {"
        + "  System.out.print(new java.io.BufferedReader(new java.io.InputStreamReader(System.in))"
        + "    .readLine());"
        + " }"
        + "}";
    Object first = run(source, "stdin-1\n");
    Object second = run(source, "stdin-2\n");
    Object third = run(source, "stdin-3\n");
    String changed = source + "\n";
    Object modified = run(changed, "changed\n");

    String largeOutput = "public class Main { public static void main(String[] a) "
        + "{ char[] x = new char[1024 * 1024 + 128]; java.util.Arrays.fill(x, 'x'); "
        + "System.out.print(x); } }";
    Object large = run(largeOutput, "");

    record("first", first);
    record("second", second);
    record("third", third);
    record("modified", modified);
    record("large-output", large);

    boolean pass = "AC".equals(string(VERDICT, first))
        && "stdin-1".equals(string(STDOUT, first))
        && !bool(CACHE_HIT, first) && number(COMPILE_MS, first) > 0
        && "AC".equals(string(VERDICT, second))
        && "stdin-2".equals(string(STDOUT, second))
        && bool(CACHE_HIT, second) && number(COMPILE_MS, second) == 0
        && "AC".equals(string(VERDICT, third))
        && "stdin-3".equals(string(STDOUT, third))
        && bool(CACHE_HIT, third) && number(COMPILE_MS, third) == 0
        && "AC".equals(string(VERDICT, modified))
        && "changed".equals(string(STDOUT, modified))
        && !bool(CACHE_HIT, modified)
        && "AC".equals(string(VERDICT, large))
        && string(STDOUT, large).getBytes(StandardCharsets.UTF_8).length == 1024 * 1024
        && bool(OUTPUT_TRUNCATED, large);
    if (!pass) throw new AssertionError("compile cache acceptance failed");
  }
}
