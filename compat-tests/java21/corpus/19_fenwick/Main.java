import java.util.*;
public class Main {
  static int[] bit;
  static void add(int i, int v) { for (; i < bit.length; i += i & -i) bit[i] += v; }
  static int sum(int i) { int s = 0; for (; i > 0; i -= i & -i) s += bit[i]; return s; }
  public static void main(String[] args) {
    Scanner in = new Scanner(System.in); int n = in.nextInt(), q = in.nextInt(); bit = new int[n + 1];
    for (int i = 1; i <= n; i++) add(i, in.nextInt()); StringBuilder out = new StringBuilder();
    while (q-- > 0) { int type = in.nextInt(), a = in.nextInt(), b = in.nextInt(); if (type == 1) add(a, b); else { if (out.length() > 0) out.append('\n'); out.append(sum(b) - sum(a - 1)); } }
    System.out.println(out);
  }
}
