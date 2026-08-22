#include <stdio.h>
#include <string.h>
int main(void) {
  char text[8] = "abcdef";
  memmove(text + 1, text, 5);
  text[6] = '\0';
  printf("%s\n", text);
  return 0;
}
