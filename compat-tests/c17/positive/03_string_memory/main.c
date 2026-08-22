#include <stdio.h>
#include <string.h>
int main(void) {
  char text[16];
  memset(text, 0, sizeof(text));
  memcpy(text, "C17", 3);
  printf("%zu:%s\n", strlen(text), text);
  return 0;
}
