#include <stdio.h>
#include <time.h>
int main(void) {
  time_t epoch = (time_t)0;
  struct tm *t = gmtime(&epoch);
  if (!t) return 2;
  printf("%d-%02d-%02d\n", t->tm_year + 1900, t->tm_mon + 1, t->tm_mday);
  return 0;
}
