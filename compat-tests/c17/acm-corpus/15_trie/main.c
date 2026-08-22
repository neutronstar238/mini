#include <stdio.h>
#include <string.h>
typedef struct Node { int next[26]; int terminal; } Node;
int main(void) {
  Node nodes[32] = {{{0}}}; int count=1;
  const char *words[]={"cat","car","dog"};
  for(int w=0;w<3;++w){int cur=0;for(size_t i=0;i<strlen(words[w]);++i){int c=words[w][i]-'a';if(!nodes[cur].next[c])nodes[cur].next[c]=count++;cur=nodes[cur].next[c];}nodes[cur].terminal=1;}
  int cur=0; const char *q="car"; for(size_t i=0;i<strlen(q);++i)cur=nodes[cur].next[q[i]-'a'];
  printf("%d\n", nodes[cur].terminal);
  return 0;
}
