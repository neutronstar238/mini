import java.util.*;
public class Main {
  static List<List<Integer>> g;
  static boolean[] seen;
  static void dfs(int u, StringBuilder out) {
    seen[u] = true;
    if (out.length() > 0) out.append(' ');
    out.append(u);
    for (int v : g.get(u)) if (!seen[v]) dfs(v, out);
  }
  public static void main(String[] args) {
    Scanner in = new Scanner(System.in);
    int n = in.nextInt(), m = in.nextInt();
    g = new ArrayList<>();
    for (int i = 0; i <= n; i++) g.add(new ArrayList<>());
    for (int i = 0; i < m; i++) { int u = in.nextInt(), v = in.nextInt(); g.get(u).add(v); }
    int start = in.nextInt(); seen = new boolean[n + 1]; StringBuilder out = new StringBuilder();
    dfs(start, out); System.out.println(out);
  }
}
