import java.io.*;
public class Main {
  public static void main(String[] args) throws Exception { BufferedReader br = new BufferedReader(new InputStreamReader(System.in)); PrintWriter out = new PrintWriter(new BufferedWriter(new OutputStreamWriter(System.out))); int n = Integer.parseInt(br.readLine()); for (int i = n; i >= 1; i--) out.println(i * i); out.flush(); }
}
