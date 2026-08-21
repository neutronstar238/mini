import java.util.*;
public class Main {
  public static void main(String[] args) {
    Scanner in = new Scanner(System.in); int n = in.nextInt(); int[] tail = new int[n]; int len = 0;
    for (int i = 0; i < n; i++) { int x = in.nextInt(), p = Arrays.binarySearch(tail, 0, len, x); if (p < 0) p = -p - 1; tail[p] = x; if (p == len) len++; }
    System.out.println(len);
  }
}
