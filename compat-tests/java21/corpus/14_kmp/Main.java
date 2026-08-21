import java.io.*;
public class Main {
  static int[] prefix(String p) { int[] pi = new int[p.length()]; for (int i = 1; i < p.length(); i++) { int j = pi[i - 1]; while (j > 0 && p.charAt(i) != p.charAt(j)) j = pi[j - 1]; if (p.charAt(i) == p.charAt(j)) j++; pi[i] = j; } return pi; }
  public static void main(String[] args) throws Exception {
    BufferedReader br = new BufferedReader(new InputStreamReader(System.in)); String text = br.readLine(), pattern = br.readLine(); int[] pi = prefix(pattern), j = {0};
    int count = 0; for (int i = 0; i < text.length(); i++) { while (j[0] > 0 && text.charAt(i) != pattern.charAt(j[0])) j[0] = pi[j[0] - 1]; if (text.charAt(i) == pattern.charAt(j[0])) j[0]++; if (j[0] == pattern.length()) { count++; j[0] = pi[j[0] - 1]; } }
    System.out.println(count);
  }
}
