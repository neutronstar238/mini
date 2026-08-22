#include <stdio.h>
enum Color { RED = 2, BLUE = 5 };
union Bits { unsigned value; unsigned char bytes[4]; };
struct Item { enum Color color; union Bits bits; };
int main(void) {
  struct Item item = {BLUE, {.value = 9}};
  printf("%d:%u\n", item.color, item.bits.value);
  return 0;
}
