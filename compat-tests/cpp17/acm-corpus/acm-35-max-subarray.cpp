#include <bits/stdc++.h>
using namespace std;
int main(){vector<int>a{-2,3,-1,4,-5};int b=0,s=-1e9;for(int x:a)b=max(x,b+x),s=max(s,b);cout<<s<<"\n";}
