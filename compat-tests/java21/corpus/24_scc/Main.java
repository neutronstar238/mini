import java.util.*;
public class Main {
  static List<List<Integer>> g, rg; static boolean[] seen; static ArrayList<Integer> order;
  static void dfs1(int u) { seen[u] = true; for (int v : g.get(u)) if (!seen[v]) dfs1(v); order.add(u); }
  static void dfs2(int u) { seen[u] = true; for (int v : rg.get(u)) if (!seen[v]) dfs2(v); }
  public static void main(String[] args) { Scanner in = new Scanner(System.in); int n = in.nextInt(), m = in.nextInt(); g = new ArrayList<>(); rg = new ArrayList<>(); for (int i = 0; i <= n; i++) { g.add(new ArrayList<>()); rg.add(new ArrayList<>()); } for (int i = 0; i < m; i++) { int u = in.nextInt(), v = in.nextInt(); g.get(u).add(v); rg.get(v).add(u); } seen = new boolean[n + 1]; order = new ArrayList<>(); for (int i = 1; i <= n; i++) if (!seen[i]) dfs1(i); Arrays.fill(seen, false); int count = 0; for (int i = order.size() - 1; i >= 0; i--) if (!seen[order.get(i)]) { dfs2(order.get(i)); count++; } System.out.println(count); }
}
