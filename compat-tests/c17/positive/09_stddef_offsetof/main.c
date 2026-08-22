#include <stddef.h>
#include <stdio.h>
struct Record { char tag; int value; };
int main(void) {
  printf("%zu:%zu\n", sizeof(struct Record), offsetof(struct Record, value));
  return 0;
}
