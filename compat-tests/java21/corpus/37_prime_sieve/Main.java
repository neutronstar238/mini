import java.util.*;
public class Main {
  public static void main(String[] args) { int n = new Scanner(System.in).nextInt(); boolean[] composite = new boolean[n + 1]; StringBuilder out = new StringBuilder(); for (int i = 2; i <= n; i++) { if (!composite[i]) { if (out.length() > 0) out.append(' '); out.append(i); for (long j = (long) i * i; j <= n; j += i) composite[(int) j] = true; } } System.out.println(out); }
}
