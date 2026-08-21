import java.util.*;
public class Main {
  public static void main(String[] args) {
    Scanner in = new Scanner(System.in);
    int n = in.nextInt(), m = in.nextInt(), inf = 1_000_000_000;
    int[][] d = new int[n + 1][n + 1];
    for (int i = 1; i <= n; i++) Arrays.fill(d[i], inf);
    for (int i = 1; i <= n; i++) d[i][i] = 0;
    for (int i = 0; i < m; i++) { int u = in.nextInt(), v = in.nextInt(), w = in.nextInt(); d[u][v] = Math.min(d[u][v], w); }
    for (int k = 1; k <= n; k++) for (int i = 1; i <= n; i++) for (int j = 1; j <= n; j++)
      if (d[i][k] < inf && d[k][j] < inf) d[i][j] = Math.min(d[i][j], d[i][k] + d[k][j]);
    int s = in.nextInt(), t = in.nextInt(); System.out.println(d[s][t]);
  }
}
