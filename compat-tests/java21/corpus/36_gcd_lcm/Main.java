import java.util.*;
public class Main {
  static long gcd(long a, long b) { while (b != 0) { long t = a % b; a = b; b = t; } return Math.abs(a); }
  public static void main(String[] args) { Scanner in = new Scanner(System.in); long a = in.nextLong(), b = in.nextLong(), g = gcd(a, b); System.out.println(g + " " + (a / g * b)); }
}
