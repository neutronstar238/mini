import java.io.*;
import java.util.*;
public class Main {
  static class Node { Map<Character, Node> next = new HashMap<>(); boolean word; }
  static void add(Node root, String s) { Node p = root; for (char c : s.toCharArray()) p = p.next.computeIfAbsent(c, k -> new Node()); p.word = true; }
  static boolean has(Node root, String s) { Node p = root; for (char c : s.toCharArray()) { p = p.next.get(c); if (p == null) return false; } return p.word; }
  public static void main(String[] args) throws Exception {
    BufferedReader br = new BufferedReader(new InputStreamReader(System.in)); Node root = new Node();
    int n = Integer.parseInt(br.readLine()); for (int i = 0; i < n; i++) add(root, br.readLine());
    System.out.println(has(root, br.readLine()) ? "YES" : "NO");
  }
}
