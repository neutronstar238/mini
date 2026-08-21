import java.util.*;
public class Main {
    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        int n = in.nextInt();
        long[] prefix = new long[n + 1];
        for (int i = 1; i <= n; i++) prefix[i] = prefix[i - 1] + in.nextInt();
        int m = in.nextInt();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < m; i++) {
            int l = in.nextInt(), r = in.nextInt();
            sb.append(prefix[r] - prefix[l - 1]).append('\n');
        }
        System.out.print(sb);
    }
}