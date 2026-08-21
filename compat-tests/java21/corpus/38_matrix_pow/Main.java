import java.util.*;
public class Main {
  static long[][] mul(long[][] a, long[][] b) { long[][] c = new long[2][2]; for (int i = 0; i < 2; i++) for (int k = 0; k < 2; k++) for (int j = 0; j < 2; j++) c[i][j] += a[i][k] * b[k][j]; return c; }
  public static void main(String[] args) { Scanner in = new Scanner(System.in); long e = in.nextLong(); long[][] a = {{in.nextLong(), in.nextLong()}, {in.nextLong(), in.nextLong()}}, r = {{1, 0}, {0, 1}}; while (e > 0) { if ((e & 1) != 0) r = mul(r, a); a = mul(a, a); e >>= 1; } System.out.println(r[0][0] + " " + r[0][1]); System.out.println(r[1][0] + " " + r[1][1]); }
}
