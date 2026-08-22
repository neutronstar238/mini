#include <stdio.h>
static int gcd(int a,int b){while(b){int t=a%b;a=b;b=t;}return a;}
int main(void){int a=12,b=18,g=gcd(a,b);printf("%d:%d\n",g,a/g*b);return 0;}
