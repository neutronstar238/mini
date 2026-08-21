import java.util.*;
public class Main {
    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        int n = in.nextInt(), q = in.nextInt();
        int[] a = new int[n];
        for (int i = 0; i < n; i++) a[i] = in.nextInt();
        Arrays.sort(a);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < q; i++) {
            int x = in.nextInt();
            int idx = Arrays.binarySearch(a, x);
            sb.append(idx >= 0 ? 1 : 0).append('\n');
        }
        System.out.print(sb);
    }
}