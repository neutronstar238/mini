#include <stdio.h>
int main(void) {
  char buffer[32];
  int length = snprintf(buffer, sizeof(buffer), "C%d", 17);
  printf("%d:%s\n", length, buffer);
  return 0;
}
