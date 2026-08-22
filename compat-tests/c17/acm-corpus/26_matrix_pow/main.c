#include <stdio.h>
typedef struct{long long a,b,c,d;} Mat;
static Mat mul(Mat x,Mat y){return (Mat){x.a*y.a+x.b*y.c,x.a*y.b+x.b*y.d,x.c*y.a+x.d*y.c,x.c*y.b+x.d*y.d};}
static Mat power(Mat x,int e){Mat r={1,0,0,1};while(e){if(e&1)r=mul(r,x);x=mul(x,x);e>>=1;}return r;}
int main(void){Mat f={1,1,1,0};printf("%lld\n",power(f,10).b);return 0;}
