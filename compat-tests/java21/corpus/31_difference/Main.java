import java.util.*;
public class Main {
  public static void main(String[] args) { Scanner in = new Scanner(System.in); int n = in.nextInt(), q = in.nextInt(); long[] diff = new long[n + 2]; for (int i = 0; i < q; i++) { int l = in.nextInt(), r = in.nextInt(), v = in.nextInt(); diff[l] += v; diff[r + 1] -= v; } long cur = 0; StringBuilder out = new StringBuilder(); for (int i = 1; i <= n; i++) { cur += diff[i]; if (i > 1) out.append(' '); out.append(cur); } System.out.println(out); }
}
