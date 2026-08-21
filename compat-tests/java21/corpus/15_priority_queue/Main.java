import java.util.*;
public class Main {
  public static void main(String[] args) {
    Scanner in = new Scanner(System.in); int n = in.nextInt(); PriorityQueue<Integer> q = new PriorityQueue<>();
    for (int i = 0; i < n; i++) q.offer(in.nextInt());
    StringBuilder out = new StringBuilder(); while (!q.isEmpty()) { if (out.length() > 0) out.append(' '); out.append(q.poll()); }
    System.out.println(out);
  }
}
