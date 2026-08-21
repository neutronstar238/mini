import java.io.*;
import java.util.*;
public class Main {
  static int[] parent, size;
  static int find(int x) { return parent[x] == x ? x : (parent[x] = find(parent[x])); }
  static void join(int a, int b) { a = find(a); b = find(b); if (a != b) { if (size[a] < size[b]) { int t = a; a = b; b = t; } parent[b] = a; size[a] += size[b]; } }
  public static void main(String[] args) throws Exception {
    BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
    StringTokenizer st = new StringTokenizer(br.readLine());
    int n = Integer.parseInt(st.nextToken()), m = Integer.parseInt(st.nextToken());
    parent = new int[n + 1]; size = new int[n + 1];
    for (int i = 1; i <= n; i++) { parent[i] = i; size[i] = 1; }
    for (int i = 0; i < m; i++) { st = new StringTokenizer(br.readLine()); join(Integer.parseInt(st.nextToken()), Integer.parseInt(st.nextToken())); }
    st = new StringTokenizer(br.readLine()); int a = Integer.parseInt(st.nextToken()), b = Integer.parseInt(st.nextToken());
    System.out.println(find(a) == find(b) ? "YES" : "NO");
  }
}
