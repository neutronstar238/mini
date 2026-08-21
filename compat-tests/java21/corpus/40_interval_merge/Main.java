import java.util.*;
public class Main {
  public static void main(String[] args) { Scanner in = new Scanner(System.in); int n = in.nextInt(); int[][] a = new int[n][2]; for (int i = 0; i < n; i++) { a[i][0] = in.nextInt(); a[i][1] = in.nextInt(); } Arrays.sort(a, Comparator.comparingInt(x -> x[0])); StringBuilder out = new StringBuilder(); int l = a[0][0], r = a[0][1]; for (int i = 1; i < n; i++) { if (a[i][0] <= r) r = Math.max(r, a[i][1]); else { if (out.length() > 0) out.append(' '); out.append(l).append('-').append(r); l = a[i][0]; r = a[i][1]; } } if (out.length() > 0) out.append(' '); out.append(l).append('-').append(r); System.out.println(out); }
}
