#include <stdio.h>
static int inverse(int a,int mod){for(int x=1;x<mod;++x)if(a*x%mod==1)return x;return -1;}
int main(void){printf("%d\n",inverse(3,11));return 0;}
