#include <stdio.h>
int main(void){int n=20,prime[21];for(int i=0;i<=n;++i)prime[i]=1;prime[0]=prime[1]=0;for(int p=2;p*p<=n;++p)if(prime[p])for(int j=p*p;j<=n;j+=p)prime[j]=0;int count=0;for(int i=2;i<=n;++i)count+=prime[i];printf("%d\n",count);return 0;}
