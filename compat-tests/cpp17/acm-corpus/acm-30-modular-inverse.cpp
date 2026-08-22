#include <bits/stdc++.h>
using namespace std;
long long e(long long a,long long b,long long&x,long long&y){if(!b){x=1;y=0;return a;}long long X,Y,g=e(b,a%b,X,Y);x=Y;y=X-a/b*Y;return g;}
int main(){long long x,y;e(3,11,x,y);cout<<(x%11+11)%11<<"\n";}
