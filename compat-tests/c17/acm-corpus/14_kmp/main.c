#include <stdio.h>
#include <string.h>
int main(void) {
  const char *text = "ababcabcacbab", *pat = "abcac";
  int n = (int)strlen(pat), pi[8] = {0};
  for (int i=1,j=0;i<n;++i){while(j&&pat[i]!=pat[j])j=pi[j-1];if(pat[i]==pat[j])++j;pi[i]=j;}
  int pos=-1;
  for(int i=0,j=0;text[i];++i){while(j&&text[i]!=pat[j])j=pi[j-1];if(text[i]==pat[j])++j;if(j==n){pos=i-n+1;break;}}
  printf("%d\n", pos);
  return 0;
}
