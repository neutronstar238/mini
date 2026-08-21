import java.util.*;
public class Main {
  public static void main(String[] args) {
    Scanner in = new Scanner(System.in); int n = in.nextInt(), m = in.nextInt(); List<List<Integer>> g = new ArrayList<>(); for (int i = 0; i <= n; i++) g.add(new ArrayList<>()); int[] deg = new int[n + 1];
    for (int i = 0; i < m; i++) { int u = in.nextInt(), v = in.nextInt(); g.get(u).add(v); deg[v]++; } for (List<Integer> x : g) Collections.sort(x);
    ArrayDeque<Integer> q = new ArrayDeque<>(); for (int i = 1; i <= n; i++) if (deg[i] == 0) q.add(i); StringBuilder out = new StringBuilder(); int count = 0;
    while (!q.isEmpty()) { int u = q.remove(); if (out.length() > 0) out.append(' '); out.append(u); count++; for (int v : g.get(u)) if (--deg[v] == 0) q.add(v); }
    System.out.println(count == n ? out : "CYCLE");
  }
}
