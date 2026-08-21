import java.util.*;
public class Main {
    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        int n = in.nextInt();
        List<Integer> list = new ArrayList<>();
        for (int i = 0; i < n; i++) list.add(in.nextInt());
        Collections.sort(list);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n; i++) sb.append(list.get(i)).append(i + 1 == n ? '\n' : ' ');
        System.out.print(sb);
    }
}