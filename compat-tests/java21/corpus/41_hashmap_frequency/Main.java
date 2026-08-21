import java.util.*;
public class Main {
  public static void main(String[] args) { Scanner in = new Scanner(System.in); int n = in.nextInt(); Map<String, Integer> counts = new HashMap<>(); for (int i = 0; i < n; i++) { String s = in.next(); counts.put(s, counts.getOrDefault(s, 0) + 1); } String best = ""; for (String s : counts.keySet()) if (best.isEmpty() || counts.get(s) > counts.get(best) || counts.get(s).equals(counts.get(best)) && s.compareTo(best) < 0) best = s; System.out.println(best + " " + counts.get(best)); }
}
