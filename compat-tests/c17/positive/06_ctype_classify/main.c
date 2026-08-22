#include <ctype.h>
#include <stdio.h>
int main(void) {
  const char *s = "A1-b2";
  int letters = 0, digits = 0;
  for (const char *p = s; *p; ++p) {
    if (isalpha((unsigned char)*p)) ++letters;
    if (isdigit((unsigned char)*p)) ++digits;
  }
  printf("%d:%d\n", letters, digits);
  return 0;
}
