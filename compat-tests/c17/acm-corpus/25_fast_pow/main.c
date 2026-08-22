#include <stdio.h>
static long long modpow(long long a,long long e,long long mod){long long r=1;while(e){if(e&1)r=r*a%mod;a=a*a%mod;e>>=1;}return r;}
int main(void){printf("%lld\n",modpow(2,10,1000));return 0;}
