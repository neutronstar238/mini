package org.minioj.browserjdk;

import java.io.ByteArrayInputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.TimeZone;

/** Runtime isolation acceptance cases A-L for the persistent CompileServer. */
public final class CompileServerIsolationHarness {
  private static final Method RUN;
  private static final Method VERDICT;
  private static final Method STDOUT;
  private static final Method STDERR;

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
    } catch (ReflectiveOperationException error) {
      throw new ExceptionInInitializerError(error);
    }
  }

  private static Method accessor(Class<?> type, String name) throws NoSuchMethodException {
    Method method = type.getDeclaredMethod(name);
    method.setAccessible(true);
    return method;
  }

  private static Object run(String source) throws Exception { return run(source, ""); }

  private static Object run(String source, String input) throws Exception {
    return RUN.invoke(null, "Main", source,
        new ByteArrayInputStream(input.getBytes(StandardCharsets.UTF_8)));
  }

  private static String value(Method method, Object result) throws Exception {
    return (String) method.invoke(result);
  }

  private static void check(String name, Object result, String verdict, String stdout,
                            String stderr) throws Exception {
    String actualVerdict = value(VERDICT, result);
    String actualStdout = value(STDOUT, result);
    String actualStderr = value(STDERR, result);
    if (!verdict.equals(actualVerdict) || !stdout.equals(actualStdout)
        || !stderr.equals(actualStderr)) {
      throw new AssertionError(name + " expected " + verdict + "/" + stdout + "/" + stderr
          + " got " + actualVerdict + "/" + actualStdout + "/" + actualStderr);
    }
    System.out.println("{\"name\":\"" + name + "\",\"verdict\":\""
        + actualVerdict + "\",\"stdout\":\"" + quote(actualStdout)
        + "\",\"stderr\":\"" + quote(actualStderr) + "\"}");
  }

  private static String quote(String value) {
    return value.replace("\\", "\\\\").replace("\"", "\\\"")
        .replace("\r", "\\r").replace("\n", "\\n");
  }

  public static void main(String[] args) throws Exception {
    // A. static primitive field; B. static collection.
    String primitive = "public class Main { static int x; public static void main(String[] a) "
        + "{ System.out.println(++x); } }";
    String collection = "public class Main { static java.util.List<String> xs = "
        + "new java.util.ArrayList<>(); public static void main(String[] a) "
        + "{ xs.add(\"x\"); System.out.println(xs.size()); } }";
    check("A-1", run(primitive), "AC", "1\n", "");
    check("A-2", run(primitive), "AC", "1\n", "");
    check("A-3", run(primitive), "AC", "1\n", "");
    check("B-1", run(collection), "AC", "1\n", "");
    check("B-2", run(collection), "AC", "1\n", "");

    // C. System.in is a fresh stream and D/E output streams are per run.
    String input = "public class Main { public static void main(String[] a) throws Exception "
        + "{ System.out.print(new java.io.BufferedReader(new java.io.InputStreamReader(System.in))"
        + ".readLine()); } }";
    check("C-1", run(input, "one\n"), "AC", "one", "");
    check("C-2", run(input, "two\n"), "AC", "two", "");
    String out = "public class Main { public static void main(String[] a) "
        + "{ System.out.print(\"OUT\"); } }";
    check("D-1", run(out), "AC", "OUT", "");
    check("D-2", run(out), "AC", "OUT", "");
    String err = "public class Main { public static void main(String[] a) "
        + "{ System.err.print(\"ERR\"); } }";
    check("E-1", run(err), "AC", "", "ERR");
    check("E-2", run(err), "AC", "", "ERR");

    // F. An exception does not poison the next execution.
    String failure = "public class Main { public static void main(String[] a) "
        + "{ throw new IllegalStateException(\"expected\"); } }";
    String alive = "public class Main { public static void main(String[] a) "
        + "{ System.out.print(\"ALIVE\"); } }";
    Object failed = run(failure);
    if (!"RE".equals(value(VERDICT, failed))) throw new AssertionError("F-1 did not fail");
    check("F-2", run(alive), "AC", "ALIVE", "");

    // G. Same source and H. different source back-to-back.
    String same = "public class Main { public static void main(String[] a) "
        + "{ System.out.print(\"SAME\"); } }";
    check("G-1", run(same), "AC", "SAME", "");
    check("G-2", run(same), "AC", "SAME", "");
    String one = "public class Main { public static void main(String[] a) "
        + "{ System.out.print(\"ONE\"); } }";
    String two = "public class Main { public static void main(String[] a) "
        + "{ System.out.print(\"TWO\"); } }";
    check("H-1", run(one), "AC", "ONE", "");
    check("H-2", run(two), "AC", "TWO", "");

    // I. The user class is loaded by a fresh loader each time.
    String identity = "public class Main { public static void main(String[] a) "
        + "{ System.out.print(System.identityHashCode(Main.class.getClassLoader())); } }";
    String loaderOne = value(STDOUT, run(identity));
    String loaderTwo = value(STDOUT, run(identity));
    if (loaderOne.equals(loaderTwo)) {
      throw new AssertionError("I: class-loader identity was reused: " + loaderOne);
    }
    System.out.println("{\"name\":\"I\",\"first\":\"" + loaderOne
        + "\",\"second\":\"" + loaderTwo + "\"}");

    // J. System properties, K. Locale, L. TimeZone are measured and restored.
    final String property = "phase7.isolation.property";
    String mutateProperty = "public class Main { public static void main(String[] a) "
        + "{ System.setProperty(\"" + property + "\", \"MUTATED\"); "
        + "System.out.print(System.getProperty(\"" + property + "\")); } }";
    String readProperty = "public class Main { public static void main(String[] a) "
        + "{ System.out.print(System.getProperty(\"" + property + "\", \"ABSENT\")); } }";
    check("J-1", run(mutateProperty), "AC", "MUTATED", "");
    check("J-2", run(readProperty), "AC", "ABSENT", "");

    String baselineLocale = Locale.getDefault().toLanguageTag();
    String mutateLocale = "public class Main { public static void main(String[] a) "
        + "{ java.util.Locale.setDefault(java.util.Locale.FRANCE); "
        + "System.out.print(java.util.Locale.getDefault().toLanguageTag()); } }";
    String readLocale = "public class Main { public static void main(String[] a) "
        + "{ System.out.print(java.util.Locale.getDefault().toLanguageTag()); } }";
    check("K-1", run(mutateLocale), "AC", "fr-FR", "");
    check("K-2", run(readLocale), "AC", baselineLocale, "");

    String baselineTimeZone = TimeZone.getDefault().getID();
    String mutateTimeZone = "public class Main { public static void main(String[] a) "
        + "{ java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone(\"UTC\")); "
        + "System.out.print(java.util.TimeZone.getDefault().getID()); } }";
    String readTimeZone = "public class Main { public static void main(String[] a) "
        + "{ System.out.print(java.util.TimeZone.getDefault().getID()); } }";
    check("L-1", run(mutateTimeZone), "AC", "UTC", "");
    check("L-2", run(readTimeZone), "AC", baselineTimeZone, "");
  }
}
