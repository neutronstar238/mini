import java.io.*;
public class Main {
  static class FastScanner { final InputStream in = new BufferedInputStream(System.in); final byte[] b = new byte[1 << 15]; int p, n; int read() throws IOException { if (p >= n) { n = in.read(b); p = 0; if (n < 0) return -1; } return b[p++]; } long nextLong() throws IOException { int c; do c = read(); while (c <= 32 && c >= 0); long v = 0; while (c > 32) { v = v * 10 + c - '0'; c = read(); } return v; } }
  public static void main(String[] args) throws Exception { FastScanner fs = new FastScanner(); int n = (int) fs.nextLong(); long sum = 0; for (int i = 0; i < n; i++) sum += fs.nextLong(); System.out.println(n + " " + sum); }
}
