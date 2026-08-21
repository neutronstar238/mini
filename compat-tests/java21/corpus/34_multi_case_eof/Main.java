import java.io.*;
import java.util.*;
public class Main {
  public static void main(String[] args) throws Exception { BufferedReader br = new BufferedReader(new InputStreamReader(System.in)); String line; int cases = 0; long total = 0; while ((line = br.readLine()) != null) { if (line.isBlank()) continue; StringTokenizer st = new StringTokenizer(line); while (st.hasMoreTokens()) { total += Long.parseLong(st.nextToken()); cases++; } } System.out.println(cases + " " + total); }
}
