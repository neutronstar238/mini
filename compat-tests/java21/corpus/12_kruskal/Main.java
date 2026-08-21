import java.util.*;
public class Main {
  static class Edge { int u, v, w; Edge(int u, int v, int w) { this.u = u; this.v = v; this.w = w; } }
  static int[] p;
  static int find(int x) { return p[x] == x ? x : (p[x] = find(p[x])); }
  public static void main(String[] args) {
    Scanner in = new Scanner(System.in); int n = in.nextInt(), m = in.nextInt();
    Edge[] e = new Edge[m]; for (int i = 0; i < m; i++) e[i] = new Edge(in.nextInt(), in.nextInt(), in.nextInt());
    Arrays.sort(e, Comparator.comparingInt(x -> x.w)); p = new int[n + 1]; for (int i = 1; i <= n; i++) p[i] = i;
    int answer = 0, used = 0; for (Edge x : e) if (find(x.u) != find(x.v)) { p[find(x.u)] = find(x.v); answer += x.w; used++; }
    System.out.println(used == n - 1 ? answer : -1);
  }
}
