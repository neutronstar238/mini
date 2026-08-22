#include <stdio.h>
#include <string.h>
int main(void) {
  char text[] = "a,b,c";
  int count = 0;
  for (char *part = strtok(text, ","); part; part = strtok(NULL, ",")) ++count;
  printf("%d\n", count);
  return 0;
}
