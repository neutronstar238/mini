#include <bits/stdc++.h>
using namespace std;
int main(){int a[4]={1,2,3,4};int tree[8]{};for(int i=0;i<4;i++)tree[4+i]=a[i];for(int i=3;i;i--)tree[i]=tree[i*2]+tree[i*2+1];cout<<tree[1]<<"\n";}
