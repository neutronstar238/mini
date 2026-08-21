import java.util.*;
public class Main {
  static int n; static long[] tree;
  static void build(int p, int l, int r, int[] a) { if (l == r) { tree[p] = a[l]; return; } int m = (l + r) >>> 1; build(p * 2, l, m, a); build(p * 2 + 1, m + 1, r, a); tree[p] = tree[p * 2] + tree[p * 2 + 1]; }
  static void update(int p, int l, int r, int i, int d) { if (l == r) { tree[p] += d; return; } int m = (l + r) >>> 1; if (i <= m) update(p * 2, l, m, i, d); else update(p * 2 + 1, m + 1, r, i, d); tree[p] = tree[p * 2] + tree[p * 2 + 1]; }
  static long query(int p, int l, int r, int ql, int qr) { if (ql <= l && r <= qr) return tree[p]; int m = (l + r) >>> 1; long s = 0; if (ql <= m) s += query(p * 2, l, m, ql, qr); if (qr > m) s += query(p * 2 + 1, m + 1, r, ql, qr); return s; }
  public static void main(String[] args) { Scanner in = new Scanner(System.in); n = in.nextInt(); int q = in.nextInt(); int[] a = new int[n + 1]; for (int i = 1; i <= n; i++) a[i] = in.nextInt(); tree = new long[4 * n + 4]; build(1, 1, n, a); StringBuilder out = new StringBuilder(); while (q-- > 0) { int type = in.nextInt(), x = in.nextInt(), y = in.nextInt(); if (type == 1) update(1, 1, n, x, y); else { if (out.length() > 0) out.append('\n'); out.append(query(1, 1, n, x, y)); } } System.out.println(out); }
}
