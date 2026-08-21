import java.io.*;
import java.util.*;
public class Main {
  public static void main(String[] args) throws Exception { BufferedReader br = new BufferedReader(new InputStreamReader(System.in)); String s = br.readLine(); int k = Integer.parseInt(br.readLine()); Set<String> hashes = new HashSet<>(); long base = 911382323L; for (int i = 0; i + k <= s.length(); i++) { long h = 0; for (int j = i; j < i + k; j++) h = h * base + s.charAt(j); hashes.add(Long.toUnsignedString(h)); } System.out.println(hashes.size()); }
}
