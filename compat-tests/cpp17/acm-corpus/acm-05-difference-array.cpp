#include <bits/stdc++.h>
using namespace std;
int main(){int n,m;cin>>n>>m;vector<int>d(n+2);while(m--){int l,r,x;cin>>l>>r>>x;d[l]+=x;d[r+1]-=x;}int cur=0;for(int i=1;i<=n;i++){cur+=d[i];cout<<cur<<(i==n?'\n':' ');}}
