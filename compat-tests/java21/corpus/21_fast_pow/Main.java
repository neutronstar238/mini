import java.util.*;
public class Main {
  static long pow(long a, long e, long mod) { long r = 1 % mod; a %= mod; while (e > 0) { if ((e & 1) != 0) r = r * a % mod; a = a * a % mod; e >>= 1; } return r; }
  public static void main(String[] args) { Scanner in = new Scanner(System.in); System.out.println(pow(in.nextLong(), in.nextLong(), in.nextLong())); }
}
