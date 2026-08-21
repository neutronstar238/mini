import java.io.*;
public class Main {
    static final class FastScanner {
        private final BufferedInputStream in;
        private final byte[] buffer = new byte[1 << 16];
        private int ptr = 0, len = 0;
        FastScanner(InputStream in) { this.in = new BufferedInputStream(in); }
        private int read() throws IOException {
            if (ptr >= len) { len = in.read(buffer); ptr = 0; if (len <= 0) return -1; }
            return buffer[ptr++];
        }
        long nextLong() throws IOException {
            int c; do { c = read(); if (c == -1) return Long.MIN_VALUE; } while (c <= ' ');
            boolean neg = false; if (c == '-') { neg = true; c = read(); }
            long v = 0; while (c > ' ') { v = v * 10 + (c - '0'); c = read(); }
            return neg ? -v : v;
        }
    }
    public static void main(String[] args) throws Exception {
        FastScanner fs = new FastScanner(System.in);
        long a = fs.nextLong(), b = fs.nextLong();
        System.out.println(a + b);
    }
}