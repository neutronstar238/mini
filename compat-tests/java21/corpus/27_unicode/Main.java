import java.nio.charset.StandardCharsets;
public class Main {
    public static void main(String[] args) {
        byte[] b = "你好世界 · Mini-OJ".getBytes(StandardCharsets.UTF_8);
        String s = new String(b, StandardCharsets.UTF_8);
        System.out.println(s);
    }
}