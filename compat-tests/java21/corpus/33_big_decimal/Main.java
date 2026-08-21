import java.math.*;
import java.util.*;
public class Main {
  public static void main(String[] args) { Scanner in = new Scanner(System.in); BigDecimal a = new BigDecimal(in.next()), b = new BigDecimal(in.next()); System.out.println(a.divide(b, 10, RoundingMode.HALF_UP).stripTrailingZeros().toPlainString()); }
}
