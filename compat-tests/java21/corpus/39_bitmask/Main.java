import java.util.*;
public class Main {
  public static void main(String[] args) { Scanner in = new Scanner(System.in); int n = in.nextInt(), mask = in.nextInt(); StringBuilder out = new StringBuilder().append(Integer.bitCount(mask)); for (int i = 0; i < n; i++) if ((mask & (1 << i)) != 0) out.append(' ').append(i); System.out.println(out); }
}
