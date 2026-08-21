import java.io.*;
import java.util.*;
public class Main {
    public static void main(String[] args) throws Exception {
        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
        StreamTokenizer in = new StreamTokenizer(br);
        in.nextToken();
        long a = (long) in.nval;
        in.nextToken();
        long b = (long) in.nval;
        System.out.println(a + b);
    }
}