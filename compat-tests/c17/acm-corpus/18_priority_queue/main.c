#include <stdio.h>
static void push(int *h,int *n,int x){int i=(*n)++;h[i]=x;while(i&&h[(i-1)/2]<h[i]){int t=h[i];h[i]=h[(i-1)/2];h[(i-1)/2]=t;i=(i-1)/2;}}
static int pop_max(int *h,int *n){int out=h[0],i=0;h[0]=h[--*n];while(1){int l=i*2+1,r=l+1,b=i;if(l<*n&&h[l]>h[b])b=l;if(r<*n&&h[r]>h[b])b=r;if(b==i)break;int t=h[i];h[i]=h[b];h[b]=t;i=b;}return out;}
int main(void){int h[8],n=0;push(h,&n,4);push(h,&n,9);push(h,&n,2);int first=pop_max(h,&n);int second=pop_max(h,&n);printf("%d %d\n",first,second);return 0;}
