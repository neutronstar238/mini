#include <stdio.h>
static int tree[16];
static void build(const int*a,int node,int l,int r){if(l==r){tree[node]=a[l];return;}int m=(l+r)/2;build(a,node*2,l,m);build(a,node*2+1,m+1,r);tree[node]=tree[node*2]+tree[node*2+1];}
static int query(int node,int l,int r,int ql,int qr){if(ql<=l&&r<=qr)return tree[node];int m=(l+r)/2,s=0;if(ql<=m)s+=query(node*2,l,m,ql,qr);if(qr>m)s+=query(node*2+1,m+1,r,ql,qr);return s;}
int main(void){int a[]={1,2,3,4};build(a,1,0,3);printf("%d\n",query(1,0,3,1,3));return 0;}
