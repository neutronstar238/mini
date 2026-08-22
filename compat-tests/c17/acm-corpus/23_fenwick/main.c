#include <stdio.h>
static void add(int *bit,int n,int i,int v){for(;i<=n;i+=i&-i)bit[i]+=v;}
static int sum(const int *bit,int i){int s=0;for(;i;i-=i&-i)s+=bit[i];return s;}
int main(void){int bit[6]={0};add(bit,5,1,3);add(bit,5,3,4);add(bit,5,5,2);printf("%d:%d\n",sum(bit,3),sum(bit,5));return 0;}
